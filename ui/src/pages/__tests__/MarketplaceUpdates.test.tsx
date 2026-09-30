import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";

import MarketplaceUpdates from "../MarketplaceUpdates";

function LocationProbe() {
  const location = useLocation();
  return (
    <div>
      <div>Marketplace prefs.</div>
      <div data-testid="location">
        {location.pathname}
        {location.search}
      </div>
    </div>
  );
}

describe("MarketplaceUpdates route", () => {
  it("redirects to the marketplace prefs updates section", async () => {
    render(
      <MemoryRouter initialEntries={["/MAR/marketplace-updates"]}>
        <Routes>
          <Route path="/:companyPrefix/marketplace-updates" element={<MarketplaceUpdates />} />
          <Route path="/:companyPrefix/settings" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Marketplace prefs.")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/MAR/settings?tab=marketplace&section=updates",
    );
  });
});
