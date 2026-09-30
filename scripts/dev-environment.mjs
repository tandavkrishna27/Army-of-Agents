export function buildDevEnvironment(baseEnv, tailscaleAuth) {
  const env = {
    ...baseEnv,
    AOA_UI_DEV_MIDDLEWARE: "true",
  };

  if (tailscaleAuth) {
    env.AOA_DEPLOYMENT_MODE = "authenticated";
    env.AOA_DEPLOYMENT_EXPOSURE = "private";
    env.AOA_AUTH_BASE_URL_MODE = "auto";
    env.HOST = "0.0.0.0";
    return env;
  }

  const explicitIdentityChoice = env.AOA_DEV_LOCAL_IDENTITY?.trim().length > 0;
  const hasGoogle = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  if (!explicitIdentityChoice && !hasGoogle) {
    env.AOA_DEV_LOCAL_IDENTITY = "1";
  }

  return env;
}
