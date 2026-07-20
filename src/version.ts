/**
 * Pure formatting logic for the Phase 0 walking-skeleton version banner.
 *
 * Kept separate from `main.ts`'s DOM/IPC wiring so it's unit-testable
 * without a Tauri runtime or a document (SPEC.md section 9: Vitest covers
 * pure logic).
 */
export function formatPingMessage(version: string): string {
	const trimmed = version.trim();

	if (trimmed.length === 0) {
		return "Backend did not report a version";
	}

	return `v${trimmed}`;
}
