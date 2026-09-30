import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactIntakePanel } from "./ArtifactIntakePanel";

const api = vi.hoisted(() => ({ begin: vi.fn(), putPart: vi.fn(), finalize: vi.fn(), cancel: vi.fn() }));
vi.mock("../../api/universe-intake", () => ({ universeIntakeApi: api }));

describe("ArtifactIntakePanel", () => {
  it("publishes a selected original and reports its asset", async () => {
    const receiving = { intakeId: "11111111-1111-4111-8111-111111111111", revision: 1, state: "receiving", receivedParts: [], expiresAt: new Date().toISOString(), assetId: null, reason: null };
    const published = { ...receiving, revision: 3, state: "published", receivedParts: [0], assetId: "22222222-2222-4222-8222-222222222222" };
    api.begin.mockResolvedValue(receiving); api.putPart.mockResolvedValue({ ...receiving, receivedParts: [0] }); api.finalize.mockResolvedValue(published);
    const onPublished = vi.fn();
    const { container } = render(<ArtifactIntakePanel companyId="company" destination={{kind:"canvas",conversationId:"33333333-3333-4333-8333-333333333333"}} onPublished={onPublished}/>);
    const fileInput = container.querySelector("input[type=file]") as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(["hello"], "hello.txt", { type: "text/plain" })] } });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Original ready."));
    expect(onPublished).toHaveBeenCalledWith(published.assetId);
  });
});
