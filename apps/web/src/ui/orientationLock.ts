const TOUCH_DEVICE_QUERY = "(hover: none) and (pointer: coarse)";

type OrientationLockResult = "locked" | "not_applicable" | "unsupported" | "blocked";

interface OrientationLockWindow {
  matchMedia(query: string): { matches: boolean };
  screen: {
    orientation?: {
      lock?: (orientation: "portrait") => Promise<void>;
    };
  };
}

interface OrientationLockDocument {
  visibilityState: DocumentVisibilityState;
}

export async function attemptPortraitOrientationLock(win: OrientationLockWindow = window, doc: OrientationLockDocument = document): Promise<OrientationLockResult> {
  if (doc.visibilityState !== "visible" || !win.matchMedia(TOUCH_DEVICE_QUERY).matches) {
    return "not_applicable";
  }
  const lock = win.screen.orientation?.lock;
  if (typeof lock !== "function") {
    return "unsupported";
  }
  try {
    await lock.call(win.screen.orientation, "portrait");
    return "locked";
  } catch {
    return "blocked";
  }
}
