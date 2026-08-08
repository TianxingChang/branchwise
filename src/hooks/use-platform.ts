import { useEffect, useState } from "react";
import { getPlatform } from "@/actions/app";

/** Null until the main process answers — treat as "not macOS yet". */
export function usePlatform(): string | null {
  const [platform, setPlatform] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    getPlatform()
      .then((value) => {
        if (active) {
          setPlatform(value);
        }
      })
      .catch((error) => {
        console.error("Failed to detect platform", error);
      });

    return () => {
      active = false;
    };
  }, []);

  return platform;
}

export function useIsMacOS(): boolean {
  return usePlatform() === "darwin";
}
