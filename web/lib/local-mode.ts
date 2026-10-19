/**
 * The desktop app sets NINETALK_LOCAL_MODE=1: one person on their own PC, so there is no login and
 * everything belongs to a single local user. Read at request time (proxy and server code), never at build.
 */
export const localMode = () => process.env.NINETALK_LOCAL_MODE === "1";
