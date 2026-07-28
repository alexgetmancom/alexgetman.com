import { describe, expect, it } from "bun:test";
import {
  AmbiguousPublicationError,
  ambiguousExternalMutation,
  isAmbiguousTransportFailure,
} from "../src/delivery/ambiguous-publication.js";
import { ExternalHttpError, ExternalTransportError } from "../src/foundation/http.js";
import { OperationTimeoutError } from "../src/foundation/runtime/timeout.js";

describe("ambiguous external publication", () => {
  it("marks transport loss after a mutation as requiring verification", async () => {
    const result = ambiguousExternalMutation("provider", async () => {
      throw new ExternalTransportError("connection closed before an HTTP response");
    });

    await expect(result).rejects.toBeInstanceOf(AmbiguousPublicationError);
    await expect(result).rejects.toThrow("verification_required: provider may have published");
  });

  it("does not reinterpret an authoritative provider HTTP response", async () => {
    const providerError = new ExternalHttpError("POST failed: 503", 503, "{}");
    expect(isAmbiguousTransportFailure(providerError)).toBe(false);
    await expect(
      ambiguousExternalMutation("provider", async () => {
        throw providerError;
      }),
    ).rejects.toBe(providerError);
  });

  it("does not classify preparation and validation failures as ambiguous", () => {
    expect(isAmbiguousTransportFailure(new OperationTimeoutError("provider mutation timed out"))).toBe(true);
    expect(isAmbiguousTransportFailure(new Error("media_processor_upload_timeout"))).toBe(false);
    expect(isAmbiguousTransportFailure(new Error("unsupported media type"))).toBe(false);
    expect(isAmbiguousTransportFailure(new Error("caption validation failed"))).toBe(false);
  });
});
