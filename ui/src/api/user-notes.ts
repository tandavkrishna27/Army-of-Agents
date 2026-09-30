import type { CreateUserNote, UpdateUserNote, UserNoteDto } from "@armyofagents/shared";
import { api } from "./client";

export const userNotesApi = {
  list: (companyId: string) =>
    api.get<UserNoteDto[]>(`/companies/${companyId}/user-notes`),
  create: (companyId: string, body: CreateUserNote) =>
    api.post<UserNoteDto>(`/companies/${companyId}/user-notes`, body),
  update: (companyId: string, noteId: string, body: UpdateUserNote) =>
    api.patch<UserNoteDto>(`/companies/${companyId}/user-notes/${noteId}`, body),
  archive: (companyId: string, noteId: string) =>
    api.delete<void>(`/companies/${companyId}/user-notes/${noteId}`),
};
