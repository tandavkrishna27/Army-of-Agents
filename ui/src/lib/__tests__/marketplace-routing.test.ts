import { describe, expect, it } from "vitest";
import { matchRoutes } from "react-router-dom";
import {
  AOA_DEFAULT_CREW_MARKETPLACE_ROUTE,
  MARKETPLACE_TEAM_DETAIL_ROUTE,
} from "../marketplace-constants";

const routes = [
  { path: AOA_DEFAULT_CREW_MARKETPLACE_ROUTE, id: "default-crew-roster" },
  { path: MARKETPLACE_TEAM_DETAIL_ROUTE, id: "marketplace-team-detail" },
  {
    path: ":companyPrefix",
    id: "company",
    children: [
      { path: "team/:userId/:tab", id: "human-detail" },
    ],
  },
];

describe("marketplace team route precedence", () => {
  it("keeps the legacy Default Crew URL out of the company HumanDetail route", () => {
    const matches = matchRoutes(
      routes,
      "/marketplace/team/aoa-curated/default-crew",
    );

    expect(matches?.at(-1)?.route.id).toBe("default-crew-roster");
    expect(matches?.map((match) => match.route.id)).not.toContain("human-detail");
  });

  it("keeps every other marketplace team URL in MarketplaceDetail", () => {
    const matches = matchRoutes(
      routes,
      "/marketplace/team/example-org/engineering",
    );

    expect(matches?.at(-1)?.route.id).toBe("marketplace-team-detail");
    expect(matches?.map((match) => match.route.id)).not.toContain("human-detail");
  });
});
