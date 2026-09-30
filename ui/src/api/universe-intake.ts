import {
  universeIntakeSnapshotSchema,
  type BeginUniverseIntake,
  type UniverseIntakeSnapshot,
} from "@armyofagents/shared";
import { api } from "./client";

const base = (companyId: string) => `/companies/${companyId}/universe/intakes`;

export const universeIntakeApi = {
  async begin(companyId: string, input: BeginUniverseIntake) {
    return universeIntakeSnapshotSchema.parse(await api.post<UniverseIntakeSnapshot>(base(companyId), input));
  },
  async get(companyId: string, intakeId: string, signal?: AbortSignal) {
    return universeIntakeSnapshotSchema.parse(await api.get<UniverseIntakeSnapshot>(`${base(companyId)}/${intakeId}`, { signal }));
  },
  async putPart(companyId: string, intakeId: string, index: number, bytes: ArrayBuffer, sha256: string) {
    const response = await fetch(`/api${base(companyId)}/${intakeId}/parts/${index}`, {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/octet-stream", "x-part-sha256": sha256 },
      body: bytes,
    });
    if (!response.ok) throw new Error(`Part upload failed: ${response.status}`);
    return universeIntakeSnapshotSchema.parse(await response.json());
  },
  async finalize(companyId: string, intakeId: string) {
    return universeIntakeSnapshotSchema.parse(await api.post<UniverseIntakeSnapshot>(`${base(companyId)}/${intakeId}/finalize`, {}));
  },
  async cancel(companyId: string, intakeId: string) {
    return universeIntakeSnapshotSchema.parse(await api.post<UniverseIntakeSnapshot>(`${base(companyId)}/${intakeId}/cancel`, {}));
  },
};
