/**
 * Logic for deciding whether to include a secret in the save payload.
 *
 * SPEC.md section 5 (backend handoff) specifies:
 * - secret omitted/undefined: leave existing keyring secret untouched
 * - secret "": overwrite keyring with an empty secret
 * - secret "value": set to the value
 *
 * For edit mode (existing device), the UI shows an "unchanged" placeholder.
 * The frontend must only send the `secret` field if the user actually typed something
 * (distinguished from leaving the field alone).
 */

/**
 * Decides whether to include a secret in a save payload.
 *
 * The behavior is the same for both new devices and editing existing devices:
 * - Empty secret field: return `undefined` (don't set a secret / leave keyring alone)
 * - Non-empty secret: return the secret value
 *
 * @param secretValue - the current value of the secret input field
 * @returns the secret to include in the payload, or `undefined` to omit the field
 */
export function decideSecretToSend(secretValue: string): string | undefined {
  // If the secret field is empty (user didn't type anything), don't include it
  if (secretValue === "") {
    return undefined;
  }

  // If secret is non-empty, include it (works for both new and edit)
  return secretValue;
}
