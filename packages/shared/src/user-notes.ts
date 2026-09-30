export const USER_NOTE_COLORS = ["yellow", "blue", "green", "pink"] as const;

export type UserNoteColor = typeof USER_NOTE_COLORS[number];

export interface UserNoteDto {
  id: string;
  companyId: string;
  userId: string;
  title: string | null;
  body: string;
  color: UserNoteColor;
  createdAt: string;
  updatedAt: string;
}
