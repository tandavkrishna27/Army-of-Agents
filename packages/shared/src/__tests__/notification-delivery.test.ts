import {describe,expect,it} from "vitest";
import {channelPermitted,personalDeliveryRestrictions} from "../notification-delivery.js";

describe("notification delivery boundary",()=>{
  it("never lets personal preferences expand shared channel eligibility",()=>{
    for(const deliveryMode of ["silent","digest","realtime"] as const) for(const toastEnabled of [false,true])
    for(const soundEnabled of [false,true]) for(const voiceEnabled of [false,true]) for(const soundEffects of [false,true])
    for(const spokenAnnouncements of ["inherit","quieter"] as const){
      const rule={deliveryMode,toastEnabled,soundEnabled,voiceEnabled}; const session={dnd:false,activeVoiceConversation:true,userSpeaking:false,playbackEnabled:true};
      const baseline={...session,soundEffects:true,quieter:false}; const local={...session,...personalDeliveryRestrictions({soundEffects,spokenAnnouncements})};
      for(const channel of ["toast","sound","voice"] as const) expect(!channelPermitted(channel,rule,local)||channelPermitted(channel,rule,baseline)).toBe(true);
    }
  });
  it("fails closed for silent delivery and distinct channel grants",()=>{
    const local={dnd:false,soundEffects:true,quieter:false,activeVoiceConversation:true,userSpeaking:false,playbackEnabled:true};
    expect(channelPermitted("voice",{deliveryMode:"realtime",toastEnabled:true,soundEnabled:true,voiceEnabled:false},local)).toBe(false);
    for(const channel of ["toast","sound","voice"] as const) expect(channelPermitted(channel,{deliveryMode:"silent",toastEnabled:true,soundEnabled:true,voiceEnabled:true},local)).toBe(false);
  });
});
