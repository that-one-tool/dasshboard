//! Keyboard-interactive authentication (RFC 4256): what a server asks beyond
//! the configured method — a 2FA code, a PAM conversation.

use std::sync::Arc;
use std::time::Duration;

use russh::client::{AuthResult, KeyboardInteractiveAuthResponse, Prompt};
use russh::{MethodKind, MethodSet};
use tokio::sync::oneshot::{self, error::RecvError};
use uuid::Uuid;
use zeroize::Zeroizing;

use super::deadline::ConnectDeadline;
use super::prompts::{
    AuthAnswers, AuthPromptField, AuthPromptPayload, ConnectPrompter, PromptClosedNotice,
    PromptRegistry,
};
use crate::error::AppError;

/// Questions answered in one keyboard-interactive exchange before giving up:
/// a server can't keep a connection asking forever.
const MAX_ROUNDS: usize = 8;
/// Keyboard-interactive exchanges in a row (a server may want two factors
/// through it, each a partial success).
const MAX_PHASES: usize = 3;
/// Questions in one round beyond which a server is refused (a hostile one
/// could otherwise flood the dialog with inputs).
const MAX_FIELDS: usize = 16;
/// Server-written texts are clipped to this many characters for display.
const MAX_TEXT_CHARS: usize = 1024;
/// Longest wait for the dialog to show a prompt queued behind others (it
/// shows one at a time): a prompt the user never sees must end too.
pub(super) const AUTH_PROMPT_QUEUE_TIMEOUT: Duration = Duration::from_secs(300);

/// One keyboard-interactive round, as the server worded it.
pub(super) struct AuthRound<'a> {
    pub(super) name: &'a str,
    pub(super) instructions: &'a str,
    pub(super) prompts: &'a [Prompt],
}

/// The server side of keyboard-interactive (a russh handle in production).
pub(super) trait KbdTransport {
    async fn start(&mut self, username: &str) -> Result<KeyboardInteractiveAuthResponse, AppError>;
    async fn respond(
        &mut self,
        answers: Vec<String>,
    ) -> Result<KeyboardInteractiveAuthResponse, AppError>;
}

/// Who answers a round (the user, in production).
pub(super) trait AnswerSource {
    async fn ask(&self, round: &AuthRound<'_>) -> Result<Zeroizing<Vec<String>>, AppError>;
    /// Show a round that asks nothing ("approve the push on your phone").
    fn inform(&self, round: &AuthRound<'_>);
}

/// Whether `result` leaves the server wanting keyboard-interactive: after a
/// partial success (2FA), after a rejected saved password (PAM may take it
/// that way), or when the server doesn't offer the method tried at all. A
/// plain wrong key still fails without asking anything.
pub(super) fn needs_keyboard_interactive(result: &AuthResult, tried: MethodKind) -> bool {
    let AuthResult::Failure {
        remaining_methods,
        partial_success,
    } = result
    else {
        return false;
    };
    let offered = |kind: MethodKind| remaining_methods.contains(&kind);
    offered(MethodKind::KeyboardInteractive)
        && (*partial_success || tried == MethodKind::Password || !offered(tried))
}

/// Take authentication from the configured method's `first` result to the
/// end, through keyboard-interactive when the server needs it. The saved
/// password may answer a password question (see `answer_round`) unless the
/// server already accepted it (a partial success then asks for a 2nd factor).
pub(super) async fn finish_authentication<T: KbdTransport, A: AnswerSource>(
    transport: &mut T,
    username: &str,
    first: AuthResult,
    tried: MethodKind,
    saved_password: Option<Zeroizing<String>>,
    user: &A,
) -> Result<(), AppError> {
    let mut saved = saved_password.filter(|_| !is_partial_success(&first));
    let (mut result, mut tried) = (first, tried);
    for _ in 0..MAX_PHASES {
        if !needs_keyboard_interactive(&result, tried) {
            break;
        }
        result = run_phase(transport, username, &mut saved, user).await?;
        tried = MethodKind::KeyboardInteractive;
        // A phase that didn't use it ended in a partial success at best:
        // what comes next is a second factor, never the password.
        saved = None;
    }
    if result.success() {
        return Ok(());
    }
    Err(authentication_failed())
}

fn is_partial_success(result: &AuthResult) -> bool {
    matches!(
        result,
        AuthResult::Failure {
            partial_success: true,
            ..
        }
    )
}

pub(super) fn authentication_failed() -> AppError {
    AppError::SshAuth(
        "authentication failed — check the stored password/key and the username".to_string(),
    )
}

/// One keyboard-interactive exchange, from its start to the server's verdict.
async fn run_phase<T: KbdTransport, A: AnswerSource>(
    transport: &mut T,
    username: &str,
    saved: &mut Option<Zeroizing<String>>,
    user: &A,
) -> Result<AuthResult, AppError> {
    let mut reply = transport.start(username).await?;
    for _ in 0..MAX_ROUNDS {
        let request = match into_info_request(reply) {
            Ok(request) => request,
            Err(verdict) => return Ok(verdict),
        };
        let answers = answer_round(&request.round(), saved, user).await?;
        reply = transport.respond(answers).await?;
    }
    Err(AppError::SshAuth(
        "the server kept asking authentication questions".to_string(),
    ))
}

/// A round's questions, owned as received.
struct InfoRequest {
    name: String,
    instructions: String,
    prompts: Vec<Prompt>,
}

impl InfoRequest {
    fn round(&self) -> AuthRound<'_> {
        AuthRound {
            name: &self.name,
            instructions: &self.instructions,
            prompts: &self.prompts,
        }
    }
}

/// The next round's questions, or the server's verdict.
fn into_info_request(reply: KeyboardInteractiveAuthResponse) -> Result<InfoRequest, AuthResult> {
    match reply {
        KeyboardInteractiveAuthResponse::InfoRequest {
            name,
            instructions,
            prompts,
        } => Ok(InfoRequest {
            name,
            instructions,
            prompts,
        }),
        verdict => Err(into_auth_result(verdict)),
    }
}

/// A round asking nothing is shown (if it says something) and answered
/// empty; the saved password answers the phase's first lone hidden question
/// worded as a password (also after a one-time code); the user answers the
/// rest.
/// Answers are moved, not copied, out of `Zeroizing`: no copy left unwiped.
async fn answer_round<A: AnswerSource>(
    round: &AuthRound<'_>,
    saved: &mut Option<Zeroizing<String>>,
    user: &A,
) -> Result<Vec<String>, AppError> {
    if round.prompts.is_empty() {
        show_information(round, user);
        return Ok(Vec::new());
    }
    check_field_count(round.prompts)?;
    if let Some(mut password) = saved.take_if(|_| is_password_question(round.prompts)) {
        return Ok(vec![std::mem::take(&mut *password)]);
    }
    let mut answers = user.ask(round).await?;
    Ok(std::mem::take(&mut *answers))
}

fn show_information<A: AnswerSource>(round: &AuthRound<'_>, user: &A) {
    let says_something = !(round.name.trim().is_empty() && round.instructions.trim().is_empty());
    if says_something {
        user.inform(round);
    }
}

fn check_field_count(prompts: &[Prompt]) -> Result<(), AppError> {
    if prompts.len() > MAX_FIELDS {
        return Err(AppError::SshAuth(
            "the server asked too many authentication questions at once".to_string(),
        ));
    }
    Ok(())
}

fn is_password_question(prompts: &[Prompt]) -> bool {
    matches!(prompts, [only] if !only.echo && is_password_label(&only.prompt))
}

/// What a server's password question says, in the app's languages. Matched
/// anywhere: German compounds ("Anmeldepasswort") and CJK have no spaces.
const PASSWORD_STEMS: &[&str] = &[
    "password",
    "passphrase",
    "passwort",
    "kennwort",
    "mot de passe",
    "contraseña",
    "senha",
    "パスワード",
    "密码",
];
/// What a one-time code or a password change question says (its "password"
/// is not the saved one), as whole words, so that a user or host name in the
/// label ("root@shipping-db") can't match "pin".
const NOT_PASSWORD_WORDS: &[&str] = &[
    "one time",
    "otp",
    "code",
    "token",
    "passcode",
    "pin",
    "verification",
    "sms",
    "dynamic",
    "temporary",
    "new",
    "retype",
    "confirm",
    "again",
    "repeat",
    "neues",
    "neue",
    "usage unique",
    "temporaire",
    "nouveau",
    "confirmez",
    "confirmer",
    "un solo uso",
    "temporal",
    "nueva",
    "nuevo",
    "repita",
    "confirme",
    "nova",
    "novo",
    "nuova",
    "nuovo",
    "conferma",
    "temporanea",
];
/// The same, matched anywhere (compounds, CJK, word stems).
const NOT_PASSWORD_STEMS: &[&str] = &[
    "einmal",
    "bestätig",
    "wiederhol",
    "temporár",
    "ワンタイム",
    "新しい",
    "確認",
    "动态",
    "一次性",
    "新密码",
    "确认",
];

/// Worded as a password and not as a one-time code or a new password. Unusual
/// wording is not: the user is asked, never the wrong secret sent.
fn is_password_label(label: &str) -> bool {
    let label = label.to_lowercase();
    let words = as_words(&label);
    let has_stem = |stems: &[&str]| stems.iter().any(|stem| label.contains(stem));
    let has_word = |list: &[&str]| list.iter().any(|word| words.contains(&format!(" {word} ")));
    has_stem(PASSWORD_STEMS) && !has_stem(NOT_PASSWORD_STEMS) && !has_word(NOT_PASSWORD_WORDS)
}

/// `label`'s words, space-separated and space-padded: " root shipping db ".
fn as_words(label: &str) -> String {
    let spaced: String = label
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    format!(
        " {} ",
        spaced.split_whitespace().collect::<Vec<_>>().join(" ")
    )
}

fn into_auth_result(verdict: KeyboardInteractiveAuthResponse) -> AuthResult {
    match verdict {
        KeyboardInteractiveAuthResponse::Success => AuthResult::Success,
        KeyboardInteractiveAuthResponse::Failure {
            remaining_methods,
            partial_success,
        } => AuthResult::Failure {
            remaining_methods,
            partial_success,
        },
        KeyboardInteractiveAuthResponse::InfoRequest { .. } => AuthResult::Failure {
            remaining_methods: MethodSet::empty(),
            partial_success: false,
        },
    }
}

/// Asks the user through the `auth_prompt` event and waits for their answer
/// (or cancel): `timeout` from when the dialog shows it (`on_screen`), which
/// it must do within `queue_timeout`.
pub(crate) struct PromptAsker {
    pub(super) prompter: Arc<dyn ConnectPrompter>,
    pub(super) registry: Arc<PromptRegistry<AuthAnswers>>,
    pub(super) on_screen: Arc<PromptRegistry<()>>,
    pub(super) timeout: Duration,
    pub(super) queue_timeout: Duration,
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) username: String,
    pub(super) deadline: Option<Arc<ConnectDeadline>>,
}

impl AnswerSource for PromptAsker {
    async fn ask(&self, round: &AuthRound<'_>) -> Result<Zeroizing<Vec<String>>, AppError> {
        let prompt_id = Uuid::new_v4().to_string();
        let (rx, _guard) = self.registry.register(prompt_id.clone());
        let (shown, _shown_guard) = self.on_screen.register(prompt_id.clone());
        let _paused = self.deadline.as_ref().map(ConnectDeadline::pause);
        let _closed_notice =
            PromptClosedNotice::auth(Arc::clone(&self.prompter), prompt_id.clone());
        self.prompter.on_auth_prompt(self.payload(prompt_id, round));
        let answered = self.answer(rx, shown).await;
        accept_answers(answered, round.prompts.len())
    }

    /// Shown like a prompt with no fields; nothing waits for an answer.
    fn inform(&self, round: &AuthRound<'_>) {
        let prompt_id = Uuid::new_v4().to_string();
        self.prompter.on_auth_prompt(self.payload(prompt_id, round));
    }
}

impl PromptAsker {
    /// The answer, if the prompt is shown within `queue_timeout` and answered
    /// within `timeout` of that.
    async fn answer(
        &self,
        mut answer: oneshot::Receiver<AuthAnswers>,
        shown: oneshot::Receiver<()>,
    ) -> Option<Result<AuthAnswers, RecvError>> {
        tokio::select! {
            answered = &mut answer => return Some(answered),
            _ = shown => {}
            () = tokio::time::sleep(self.queue_timeout) => return None,
        }
        tokio::time::timeout(self.timeout, answer).await.ok()
    }

    fn payload(&self, prompt_id: String, round: &AuthRound<'_>) -> AuthPromptPayload {
        AuthPromptPayload {
            prompt_id,
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            name: clip(round.name),
            instructions: clip(round.instructions),
            fields: round.prompts.iter().map(to_field).collect(),
        }
    }
}

fn to_field(prompt: &Prompt) -> AuthPromptField {
    AuthPromptField {
        label: clip(&prompt.prompt),
        echo: prompt.echo,
    }
}

fn clip(text: &str) -> String {
    text.chars().take(MAX_TEXT_CHARS).collect()
}

/// `answered`: `None` when the wait timed out.
fn accept_answers(
    answered: Option<Result<AuthAnswers, RecvError>>,
    expected: usize,
) -> Result<Zeroizing<Vec<String>>, AppError> {
    match answered {
        None => Err(AppError::SshAuth(
            "the server's authentication question went unanswered".to_string(),
        )),
        Some(Ok(Some(answers))) if answers.len() == expected => Ok(answers),
        Some(Ok(Some(_))) => Err(AppError::SshAuth(
            "the answers don't match the server's questions".to_string(),
        )),
        Some(_) => Err(AppError::SshAuth(
            "authentication was cancelled".to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::MethodSet;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    fn methods(kinds: &[MethodKind]) -> MethodSet {
        MethodSet::from(kinds)
    }

    fn rejected(kinds: &[MethodKind], partial_success: bool) -> AuthResult {
        AuthResult::Failure {
            remaining_methods: methods(kinds),
            partial_success,
        }
    }

    fn info(prompts: &[(&str, bool)]) -> KeyboardInteractiveAuthResponse {
        KeyboardInteractiveAuthResponse::InfoRequest {
            name: String::new(),
            instructions: String::new(),
            prompts: prompts
                .iter()
                .map(|(text, echo)| Prompt {
                    prompt: text.to_string(),
                    echo: *echo,
                })
                .collect(),
        }
    }

    fn kbd_failure(partial_success: bool) -> KeyboardInteractiveAuthResponse {
        KeyboardInteractiveAuthResponse::Failure {
            remaining_methods: methods(&[MethodKind::KeyboardInteractive]),
            partial_success,
        }
    }

    const KBD: MethodKind = MethodKind::KeyboardInteractive;

    /// Replays the server's replies and records what the client sent.
    #[derive(Default)]
    struct ScriptedServer {
        replies: VecDeque<KeyboardInteractiveAuthResponse>,
        starts: usize,
        sent: Vec<Vec<String>>,
    }

    impl ScriptedServer {
        fn new(replies: Vec<KeyboardInteractiveAuthResponse>) -> Self {
            ScriptedServer {
                replies: replies.into(),
                ..Default::default()
            }
        }

        fn next(&mut self) -> Result<KeyboardInteractiveAuthResponse, AppError> {
            self.replies
                .pop_front()
                .ok_or_else(|| AppError::SshAuth("script exhausted".into()))
        }
    }

    impl KbdTransport for ScriptedServer {
        async fn start(
            &mut self,
            _username: &str,
        ) -> Result<KeyboardInteractiveAuthResponse, AppError> {
            self.starts += 1;
            self.next()
        }
        async fn respond(
            &mut self,
            answers: Vec<String>,
        ) -> Result<KeyboardInteractiveAuthResponse, AppError> {
            self.sent.push(answers);
            self.next()
        }
    }

    /// Answers every round with `answer` (or fails, if `None`), recording the
    /// prompt texts it was shown.
    struct ScriptedUser {
        answer: Option<&'static str>,
        asked: RefCell<Vec<Vec<String>>>,
        informed: RefCell<Vec<String>>,
    }

    impl ScriptedUser {
        fn answering(answer: &'static str) -> Self {
            ScriptedUser {
                answer: Some(answer),
                asked: RefCell::default(),
                informed: RefCell::default(),
            }
        }
        fn cancelling() -> Self {
            ScriptedUser {
                answer: None,
                asked: RefCell::default(),
                informed: RefCell::default(),
            }
        }
    }

    impl AnswerSource for ScriptedUser {
        async fn ask(&self, round: &AuthRound<'_>) -> Result<Zeroizing<Vec<String>>, AppError> {
            let texts = round.prompts.iter().map(|p| p.prompt.clone()).collect();
            self.asked.borrow_mut().push(texts);
            let answer = self
                .answer
                .ok_or_else(|| AppError::SshAuth("cancelled".into()))?;
            Ok(Zeroizing::new(vec![
                answer.to_string();
                round.prompts.len()
            ]))
        }
        fn inform(&self, round: &AuthRound<'_>) {
            self.informed
                .borrow_mut()
                .push(round.instructions.to_string());
        }
    }

    fn saved(password: &str) -> Option<Zeroizing<String>> {
        Some(Zeroizing::new(password.to_string()))
    }

    async fn finish(
        server: &mut ScriptedServer,
        first: AuthResult,
        tried: MethodKind,
        saved_password: Option<Zeroizing<String>>,
        user: &ScriptedUser,
    ) -> Result<(), AppError> {
        finish_authentication(server, "u", first, tried, saved_password, user).await
    }

    #[test]
    fn keyboard_interactive_runs_only_when_the_server_needs_it() {
        use MethodKind::{Password, PublicKey};
        assert!(!needs_keyboard_interactive(&AuthResult::Success, Password));
        assert!(!needs_keyboard_interactive(
            &rejected(&[Password], false),
            Password
        ));
        // 2FA: the configured method was accepted, more is required.
        assert!(needs_keyboard_interactive(
            &rejected(&[KBD], true),
            PublicKey
        ));
        // A rejected saved password: PAM may take it through keyboard-interactive.
        assert!(needs_keyboard_interactive(
            &rejected(&[Password, KBD], false),
            Password
        ));
        // A plain wrong key still fails as it always did.
        assert!(!needs_keyboard_interactive(
            &rejected(&[PublicKey, KBD], false),
            PublicKey
        ));
        // A server that doesn't take keys at all.
        assert!(needs_keyboard_interactive(
            &rejected(&[KBD], false),
            PublicKey
        ));
    }

    #[tokio::test]
    async fn a_successful_configured_method_asks_nothing_more() {
        let mut server = ScriptedServer::default();
        let user = ScriptedUser::answering("x");
        let result = finish(&mut server, AuthResult::Success, KBD, None, &user).await;
        assert!(result.is_ok());
        assert_eq!(server.starts, 0);
    }

    #[tokio::test]
    async fn the_saved_password_answers_a_lone_hidden_first_question() {
        let mut server = ScriptedServer::new(vec![
            info(&[("Password: ", false)]),
            KeyboardInteractiveAuthResponse::Success,
        ]);
        let user = ScriptedUser::answering("never");
        let first = rejected(&[KBD], false);
        let result = finish(&mut server, first, MethodKind::Password, saved("pw"), &user).await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(server.sent, vec![vec!["pw".to_string()]]);
        assert!(user.asked.borrow().is_empty());
    }

    #[tokio::test]
    async fn the_user_answers_what_follows_the_saved_password() {
        let mut server = ScriptedServer::new(vec![
            info(&[]),
            info(&[("Password: ", false)]),
            info(&[("Verification code: ", false)]),
            KeyboardInteractiveAuthResponse::Success,
        ]);
        let user = ScriptedUser::answering("123456");
        let first = rejected(&[MethodKind::Password, KBD], false);
        let result = finish(&mut server, first, MethodKind::Password, saved("pw"), &user).await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(
            server.sent,
            vec![vec![], vec!["pw".to_string()], vec!["123456".to_string()]]
        );
        assert_eq!(
            *user.asked.borrow(),
            vec![vec!["Verification code: ".to_string()]]
        );
    }

    #[tokio::test]
    async fn after_a_partial_success_the_saved_password_is_never_sent() {
        let mut server = ScriptedServer::new(vec![
            info(&[("Verification code: ", false)]),
            KeyboardInteractiveAuthResponse::Success,
        ]);
        let user = ScriptedUser::answering("123456");
        let first = rejected(&[KBD], true);
        let result = finish(&mut server, first, MethodKind::Password, saved("pw"), &user).await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(server.sent, vec![vec!["123456".to_string()]]);
    }

    #[tokio::test]
    async fn the_saved_password_is_never_sent_after_a_keyboard_interactive_partial_success() {
        let mut server = ScriptedServer::new(vec![
            kbd_failure(true),
            info(&[("Verification code: ", false)]),
            KeyboardInteractiveAuthResponse::Success,
        ]);
        let user = ScriptedUser::answering("123456");
        let first = rejected(&[MethodKind::Password, KBD], false);
        let result = finish(&mut server, first, MethodKind::Password, saved("pw"), &user).await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(server.sent, vec![vec!["123456".to_string()]]);
    }

    #[tokio::test]
    async fn the_saved_password_never_answers_a_one_time_code_question() {
        let mut server = ScriptedServer::new(vec![
            info(&[("Verification code: ", false)]),
            info(&[("Password: ", false)]),
            KeyboardInteractiveAuthResponse::Success,
        ]);
        let user = ScriptedUser::answering("123456");
        let first = rejected(&[KBD], false);
        let result = finish(&mut server, first, MethodKind::Password, saved("pw"), &user).await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(
            server.sent,
            vec![vec!["123456".to_string()], vec!["pw".to_string()]]
        );
    }

    #[test]
    fn only_a_question_worded_as_a_password_gets_the_saved_one() {
        for label in [
            "Password: ",
            "Password for root@nas: ",
            "Enter passphrase:",
            "Passwort: ",
            "Mot de passe : ",
            "Contraseña: ",
            "Senha: ",
            "パスワード: ",
            "密码：",
            "(current) UNIX password: ",
            "Password for root@shipping-db: ",
            "jasper@codeserver.lan's password: ",
            "Password for pinto@pine.lan: ",
        ] {
            assert!(is_password_label(label), "{label:?}");
        }
        for label in [
            "Verification code: ",
            "One-time password (OATH) for `root': ",
            "OTP password: ",
            "Passcode or option (1-3): ",
            "Token: ",
            "PIN: ",
            "Username: ",
            "SMS password: ",
            "Temporary password: ",
            "Dynamic password: ",
            "ワンタイムパスワード: ",
            "动态密码：",
            "一次性密码：",
            "Einmalpasswort: ",
            "Mot de passe à usage unique : ",
            "Contraseña de un solo uso: ",
            "Senha temporária: ",
            "New password: ",
            "Retype new password: ",
            "Confirm password: ",
            "Enter password again: ",
            "Neues Passwort: ",
            "Passwort wiederholen: ",
            "Nouveau mot de passe : ",
            "Confirmez le mot de passe : ",
            "Nueva contraseña: ",
            "Nova senha: ",
            "Nuova password: ",
            "新しいパスワード: ",
            "新密码：",
            "确认密码：",
        ] {
            assert!(!is_password_label(label), "{label:?}");
        }
    }

    #[tokio::test]
    async fn a_round_with_too_many_questions_is_refused() {
        let labels = vec![("Q: ", true); MAX_FIELDS + 1];
        let mut server = ScriptedServer::new(vec![info(&labels)]);
        let user = ScriptedUser::answering("a");
        let result = finish(&mut server, rejected(&[KBD], true), KBD, None, &user).await;
        assert!(matches!(result, Err(AppError::SshAuth(_))), "{result:?}");
        assert!(server.sent.is_empty());
        assert!(user.asked.borrow().is_empty());
    }

    fn info_text(instructions: &str) -> KeyboardInteractiveAuthResponse {
        KeyboardInteractiveAuthResponse::InfoRequest {
            name: String::new(),
            instructions: instructions.to_string(),
            prompts: Vec::new(),
        }
    }

    #[tokio::test]
    async fn a_round_without_questions_shows_its_text_and_asks_nothing() {
        let mut server = ScriptedServer::new(vec![
            info_text("Approve the push on your phone"),
            info_text("  "),
            KeyboardInteractiveAuthResponse::Success,
        ]);
        let user = ScriptedUser::answering("x");
        let result = finish(&mut server, rejected(&[KBD], true), KBD, None, &user).await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(server.sent, vec![Vec::<String>::new(), Vec::new()]);
        assert_eq!(
            *user.informed.borrow(),
            vec!["Approve the push on your phone"]
        );
        assert!(user.asked.borrow().is_empty());
    }

    #[tokio::test]
    async fn several_questions_at_once_go_to_the_user() {
        let mut server = ScriptedServer::new(vec![
            info(&[("Password: ", false), ("Code: ", true)]),
            KeyboardInteractiveAuthResponse::Success,
        ]);
        let user = ScriptedUser::answering("a");
        let first = rejected(&[KBD], false);
        let result = finish(&mut server, first, MethodKind::Password, saved("pw"), &user).await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(server.sent, vec![vec!["a".to_string(), "a".to_string()]]);
    }

    #[tokio::test]
    async fn a_rejected_answer_fails_as_an_auth_error() {
        let mut server = ScriptedServer::new(vec![info(&[("Code: ", false)]), kbd_failure(false)]);
        let user = ScriptedUser::answering("000000");
        let first = rejected(&[KBD], true);
        let result = finish(&mut server, first, MethodKind::PublicKey, None, &user).await;
        assert!(matches!(result, Err(AppError::SshAuth(_))), "{result:?}");
    }

    #[tokio::test]
    async fn a_cancelled_question_ends_the_attempt() {
        let mut server = ScriptedServer::new(vec![info(&[("Code: ", false)])]);
        let user = ScriptedUser::cancelling();
        let first = rejected(&[KBD], true);
        let result = finish(&mut server, first, MethodKind::PublicKey, None, &user).await;
        assert!(matches!(result, Err(AppError::SshAuth(_))), "{result:?}");
        assert!(server.sent.is_empty());
    }

    #[tokio::test]
    async fn a_partial_keyboard_interactive_success_starts_another_phase() {
        let mut server = ScriptedServer::new(vec![
            info(&[("Code: ", false)]),
            kbd_failure(true),
            info(&[("Second code: ", false)]),
            KeyboardInteractiveAuthResponse::Success,
        ]);
        let user = ScriptedUser::answering("1");
        let first = rejected(&[KBD], true);
        let result = finish(&mut server, first, MethodKind::PublicKey, None, &user).await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(server.starts, 2);
    }

    #[tokio::test]
    async fn a_server_that_never_stops_asking_is_cut_off() {
        let endless = (0..MAX_ROUNDS + 1).map(|_| info(&[])).collect();
        let mut server = ScriptedServer::new(endless);
        let user = ScriptedUser::answering("x");
        let first = rejected(&[KBD], true);
        let result = finish(&mut server, first, MethodKind::PublicKey, None, &user).await;
        assert!(matches!(result, Err(AppError::SshAuth(_))), "{result:?}");
        assert_eq!(server.sent.len(), MAX_ROUNDS);
    }

    /* --- the user-facing prompt --------------------------------------- */

    use super::super::prompts::{AuthPromptPayload, HostKeyPromptPayload};
    use std::sync::Mutex;

    /// Answers each auth prompt as soon as it is raised.
    struct AnsweringPrompter {
        registry: Arc<PromptRegistry<AuthAnswers>>,
        answer: Mutex<Option<AuthAnswers>>,
        shown: Mutex<Vec<AuthPromptPayload>>,
        closed: Mutex<Vec<String>>,
    }

    impl ConnectPrompter for AnsweringPrompter {
        fn on_host_key_prompt(&self, _payload: HostKeyPromptPayload) {}
        fn on_auth_prompt(&self, payload: AuthPromptPayload) {
            if let Some(answer) = self.answer.lock().unwrap().take() {
                self.registry.respond(&payload.prompt_id, answer);
            }
            self.shown.lock().unwrap().push(payload);
        }
        fn on_auth_prompt_closed(&self, prompt_id: &str) {
            self.closed.lock().unwrap().push(prompt_id.to_string());
        }
    }

    fn asker_answering(answer: Option<AuthAnswers>) -> (PromptAsker, Arc<AnsweringPrompter>) {
        let registry = Arc::new(PromptRegistry::default());
        let prompter = Arc::new(AnsweringPrompter {
            registry: Arc::clone(&registry),
            answer: Mutex::new(answer),
            shown: Mutex::default(),
            closed: Mutex::default(),
        });
        let asker = PromptAsker {
            prompter: Arc::clone(&prompter) as Arc<dyn ConnectPrompter>,
            registry,
            on_screen: Arc::default(),
            timeout: Duration::from_millis(50),
            queue_timeout: Duration::from_millis(50),
            host: "h".into(),
            port: 22,
            username: "u".into(),
            deadline: None,
        };
        (asker, prompter)
    }

    fn one_prompt() -> Vec<Prompt> {
        vec![Prompt {
            prompt: "Code: ".into(),
            echo: false,
        }]
    }

    fn round(prompts: &[Prompt]) -> AuthRound<'_> {
        AuthRound {
            name: "n",
            instructions: "i",
            prompts,
        }
    }

    #[tokio::test]
    async fn the_user_is_shown_the_round_and_their_answer_is_returned() {
        let answer = Some(Zeroizing::new(vec!["42".to_string()]));
        let (asker, prompter) = asker_answering(Some(answer));
        let prompts = one_prompt();

        let answers = asker.ask(&round(&prompts)).await.unwrap();

        assert_eq!(answers.as_slice(), ["42".to_string()]);
        let shown = prompter.shown.lock().unwrap();
        assert_eq!(shown[0].host, "h");
        assert_eq!(shown[0].username, "u");
        assert_eq!(shown[0].fields[0].label, "Code: ");
        assert!(!shown[0].fields[0].echo);
        assert_eq!(
            *prompter.closed.lock().unwrap(),
            vec![shown[0].prompt_id.clone()]
        );
    }

    #[tokio::test]
    async fn a_cancelled_prompt_is_an_auth_error() {
        let (asker, _prompter) = asker_answering(Some(None));
        let prompts = one_prompt();
        let result = asker.ask(&round(&prompts)).await;
        assert!(matches!(result, Err(AppError::SshAuth(_))));
    }

    #[tokio::test]
    async fn an_unanswered_prompt_times_out_as_an_auth_error() {
        let (asker, prompter) = asker_answering(None);
        let prompts = one_prompt();
        let result = asker.ask(&round(&prompts)).await;
        assert!(matches!(result, Err(AppError::SshAuth(_))));
        assert_eq!(prompter.closed.lock().unwrap().len(), 1);
    }

    /// The id of the prompt `prompter` was shown, once it was.
    async fn shown_prompt_id(prompter: &AnsweringPrompter) -> String {
        loop {
            if let Some(shown) = prompter.shown.lock().unwrap().first() {
                return shown.prompt_id.clone();
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }

    #[tokio::test]
    async fn the_answer_time_starts_once_the_dialog_shows_the_prompt() {
        let (mut asker, prompter) = asker_answering(None);
        asker.queue_timeout = Duration::from_secs(5);
        let (on_screen, registry) = (Arc::clone(&asker.on_screen), Arc::clone(&asker.registry));
        let user = async {
            let prompt_id = shown_prompt_id(&prompter).await;
            tokio::time::sleep(Duration::from_millis(150)).await;
            assert!(on_screen.respond(&prompt_id, ()));
            tokio::time::sleep(Duration::from_millis(20)).await;
            registry.respond(&prompt_id, Some(Zeroizing::new(vec!["42".to_string()])));
        };
        let prompts = one_prompt();

        let asked = round(&prompts);
        let (answers, ()) = tokio::join!(asker.ask(&asked), user);

        assert_eq!(answers.unwrap().as_slice(), ["42".to_string()]);
    }

    #[tokio::test]
    async fn a_prompt_shown_late_still_gets_the_full_answer_time() {
        let (mut asker, prompter) = asker_answering(None);
        asker.queue_timeout = Duration::from_millis(100);
        asker.timeout = Duration::from_millis(300);
        let (on_screen, registry) = (Arc::clone(&asker.on_screen), Arc::clone(&asker.registry));
        let user = async {
            let prompt_id = shown_prompt_id(&prompter).await;
            tokio::time::sleep(Duration::from_millis(80)).await;
            on_screen.respond(&prompt_id, ());
            tokio::time::sleep(Duration::from_millis(100)).await;
            registry.respond(&prompt_id, Some(Zeroizing::new(vec!["42".to_string()])));
        };
        let prompts = one_prompt();

        let asked = round(&prompts);
        let (answers, ()) = tokio::join!(asker.ask(&asked), user);

        assert_eq!(answers.unwrap().as_slice(), ["42".to_string()]);
    }

    #[tokio::test]
    async fn a_shown_prompt_left_unanswered_times_out() {
        let (mut asker, prompter) = asker_answering(None);
        asker.queue_timeout = Duration::from_secs(5);
        let on_screen = Arc::clone(&asker.on_screen);
        let user = async {
            let prompt_id = shown_prompt_id(&prompter).await;
            on_screen.respond(&prompt_id, ());
        };
        let prompts = one_prompt();

        let started = std::time::Instant::now();
        let asked = round(&prompts);
        let (result, ()) = tokio::join!(asker.ask(&asked), user);

        assert!(matches!(result, Err(AppError::SshAuth(_))));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn a_prompt_never_shown_times_out_after_the_queue_limit() {
        let (mut asker, _prompter) = asker_answering(None);
        asker.timeout = Duration::from_secs(5);
        let prompts = one_prompt();

        let started = std::time::Instant::now();
        let result = asker.ask(&round(&prompts)).await;

        assert!(matches!(result, Err(AppError::SshAuth(_))));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn answers_that_do_not_match_the_questions_are_refused() {
        let answer = Some(Zeroizing::new(vec!["1".to_string(), "2".to_string()]));
        let (asker, _prompter) = asker_answering(Some(answer));
        let prompts = one_prompt();
        let result = asker.ask(&round(&prompts)).await;
        assert!(matches!(result, Err(AppError::SshAuth(_))));
    }

    #[tokio::test]
    async fn a_prompt_abandoned_mid_wait_is_announced_closed() {
        let (mut asker, prompter) = asker_answering(None);
        asker.timeout = Duration::from_secs(5);
        let prompts = one_prompt();

        let abandoned =
            tokio::time::timeout(Duration::from_millis(20), asker.ask(&round(&prompts))).await;

        assert!(abandoned.is_err());
        assert_eq!(prompter.closed.lock().unwrap().len(), 1);
        let prompt_id = prompter.shown.lock().unwrap()[0].prompt_id.clone();
        assert!(
            !asker.registry.respond(&prompt_id, None),
            "no entry left behind"
        );
    }

    #[test]
    fn information_is_shown_with_no_fields_and_needs_no_answer() {
        let (asker, prompter) = asker_answering(None);
        asker.inform(&AuthRound {
            name: "Duo",
            instructions: "Approve the push",
            prompts: &[],
        });
        let shown = prompter.shown.lock().unwrap();
        assert_eq!(shown[0].instructions, "Approve the push");
        assert!(shown[0].fields.is_empty());
        assert!(prompter.closed.lock().unwrap().is_empty());
    }

    #[test]
    fn server_texts_are_clipped() {
        let long = "x".repeat(MAX_TEXT_CHARS + 10);
        assert_eq!(clip(&long).chars().count(), MAX_TEXT_CHARS);
        assert_eq!(clip("short"), "short");
    }
}
