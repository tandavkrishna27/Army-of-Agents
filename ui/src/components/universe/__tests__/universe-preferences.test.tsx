import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_UNIVERSE_PREFERENCES } from "@armyofagents/shared";
import { UniverseSection } from "../../settings/sections/UniverseSection";
import { UNIVERSE_FIELDS } from "../../settings/sections/universe-fields";
import { contrastRatio, UNIVERSE_ACCENTS } from "../appearance-tokens";

const hook = vi.hoisted(() => ({
  snapshot:null as unknown,
  draft:{},status:"ready",error:null,conflict:null,edit:vi.fn(),discard:vi.fn(),patch:vi.fn(),reset:vi.fn(),acceptLatest:vi.fn(),
}));
vi.mock("@/context/CompanyContext",()=>({useCompany:()=>({selectedCompanyId:"company-a"})}));
vi.mock("@/hooks/useUniversePreferences",()=>({useUniversePreferences:()=>hook}));

describe("Universe personal preferences",()=>{
  beforeEach(()=>{vi.clearAllMocks();hook.snapshot={schemaVersion:1,revision:2,overrides:{},effective:DEFAULT_UNIVERSE_PREFERENCES,unavailableFields:{}};});
  it("has an exhaustive field ownership map",()=>{
    expect(Object.keys(UNIVERSE_FIELDS).sort()).toEqual(Object.keys(DEFAULT_UNIVERSE_PREFERENCES).sort());
  });
  it("edits and resets appearance without probing media",()=>{
    const getUserMedia=vi.fn(); Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia}});
    render(<UniverseSection/>);
    fireEvent.change(screen.getByLabelText("Motion"),{target:{value:"reduced"}});
    expect(hook.edit).toHaveBeenCalledWith({motion:"reduced"});
    fireEvent.click(screen.getByRole("button",{name:"Reset appearance"}));
    expect(hook.reset).toHaveBeenCalledWith("appearance");
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it("keeps every accent distinguishable on the qualified light and dark canvases",()=>{
    for (const accent of Object.values(UNIVERSE_ACCENTS)) {
      expect(contrastRatio(accent,"#f7f3f4")).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(accent,"#0d0b0c")).toBeGreaterThanOrEqual(3);
    }
  });
});
