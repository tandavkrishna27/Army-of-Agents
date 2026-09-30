const PADDING = 16;

export interface LaidOutCard {
  agentId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TeamMeta {
  id: string;
  name: string;
  color: string;
}

export interface TeamBox {
  teamId: string;
  name: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function computeTeamBoxes(
  cards: LaidOutCard[],
  memberships: Map<string, string>, // agentId -> teamId
  teams: TeamMeta[],
): TeamBox[] {
  const boxes: TeamBox[] = [];
  for (const team of teams) {
    const members = cards.filter((c) => memberships.get(c.agentId) === team.id);
    if (members.length === 0) continue;

    const minX = Math.min(...members.map((m) => m.x));
    const minY = Math.min(...members.map((m) => m.y));
    const maxX = Math.max(...members.map((m) => m.x + m.w));
    const maxY = Math.max(...members.map((m) => m.y + m.h));

    boxes.push({
      teamId: team.id,
      name: team.name,
      color: team.color,
      x: minX - PADDING,
      y: minY - PADDING,
      width: maxX - minX + PADDING * 2,
      height: maxY - minY + PADDING * 2,
    });
  }
  return boxes;
}
