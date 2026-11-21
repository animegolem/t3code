/**
 * What makes this fork's packaged app a different app from upstream's at run time, so both can be
 * open at once, each on its own data. A development run keeps upstream's names. The app ID, the
 * product name, the package name and the icon are set in scripts/build-desktop-artifact.ts.
 */

/** The Chromium profile folder. It holds the lock that allows one running copy. */
export const FORK_PROFILE_FOLDER = "t3code-dock";

/** The home a packaged app uses when T3CODE_HOME does not name one. */
export const FORK_HOME_FOLDER = ".t3-dock";
