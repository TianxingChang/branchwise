import { createRootRoute, Outlet } from "@tanstack/react-router";
import BaseLayout from "@/layouts/base-layout";

/*
 * branchwise renders one route. The template's router devtools are left out
 * here because the floating badge sits on top of the canvas.
 */
function Root() {
  return (
    <BaseLayout>
      <Outlet />
    </BaseLayout>
  );
}

export const Route = createRootRoute({
  component: Root,
});
