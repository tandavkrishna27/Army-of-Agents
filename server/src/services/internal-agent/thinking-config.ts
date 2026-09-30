/** Token budget that enables Claude CLI extended thinking in --print stream-json
 *  mode (spike-confirmed: with this env set, claude emits thinking + thinking_delta).
 *  v1 is a constant; a per-company internal_agent_config budget is a future option. */
export const COMMANDER_MAX_THINKING_TOKENS = 3000;
