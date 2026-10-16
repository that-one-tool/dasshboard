import { invokeChecked } from "./invoke";

/** One public key held by the local SSH agent, as returned by
 * {@link listAgentIdentities}. Public data only — never key material. */
export interface AgentIdentityInfo {
  algorithm: string;
  fingerprint: string;
  isSecurityKey: boolean;
  isCertificate: boolean;
  comment: string;
  openssh: string;
}

/** Whether a local SSH agent looks reachable, for the device editor's
 * agent-forwarding hint. Best-effort — the toggle stays usable regardless. */
export async function sshAgentAvailable(): Promise<boolean> {
  return invokeChecked<boolean>("ssh_agent_available");
}

/** List the identities held by the local SSH agent, for the device editor's
 * agent-auth picker. Rejects if no agent is reachable; resolves to `[]` when the
 * agent is running but holds no keys. */
export async function listAgentIdentities(): Promise<AgentIdentityInfo[]> {
  return invokeChecked<AgentIdentityInfo[]>("list_agent_identities");
}
