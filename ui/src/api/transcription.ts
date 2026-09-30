import { api } from "./client";

export const transcriptionApi = {
  transcribe: (companyId: string, audioBlob: Blob) => {
    const form = new FormData();
    form.append("file", audioBlob, "recording.webm");
    return api.postForm<{ text: string }>(`/companies/${companyId}/transcribe`, form);
  },
};
