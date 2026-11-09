import { describe, it, expect, vi } from "vitest";
import { PanelFeedback } from "./panelFeedback";

function setup() {
  const hooks = { notifyError: vi.fn(), notifySuccess: vi.fn(), resync: vi.fn() };
  return { hooks, feedback: new PanelFeedback(hooks) };
}

const error = { code: "Sftp", message: "boom" };

describe("PanelFeedback", () => {
  it("passes a success message on", () => {
    const { hooks, feedback } = setup();
    feedback.success("done");
    expect(hooks.notifySuccess).toHaveBeenCalledWith("done");
  });

  it("notify surfaces the error without a connection check", () => {
    const { hooks, feedback } = setup();
    feedback.notify(error);
    expect(hooks.notifyError).toHaveBeenCalledWith(error);
    expect(hooks.resync).not.toHaveBeenCalled();
  });

  it("report surfaces the error, then checks the connection", () => {
    const { hooks, feedback } = setup();
    feedback.report(error);
    expect(hooks.notifyError).toHaveBeenCalledWith(error);
    expect(hooks.resync).toHaveBeenCalledOnce();
  });

  it("attempt reports a failed operation and stays quiet on success", async () => {
    const { hooks, feedback } = setup();
    await feedback.attempt(async () => {});
    expect(hooks.notifyError).not.toHaveBeenCalled();

    await feedback.attempt(async () => {
      throw error;
    });
    expect(hooks.notifyError).toHaveBeenCalledWith(error);
    expect(hooks.resync).toHaveBeenCalledOnce();
  });
});
