import type React from "react";

/**
 * Full-bleed shell. The window has no native title bar — the tab strip inside
 * AppShell is the drag region, so the layout must not add chrome of its own.
 */
export default function BaseLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="h-screen w-screen overflow-hidden">{children}</div>;
}
