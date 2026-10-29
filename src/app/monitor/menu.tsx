import * as React from "react";
import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";

const Menu = MenuPrimitive.Root;
const MenuTrigger = MenuPrimitive.Trigger;

const MenuContent = React.forwardRef<
  React.ComponentRef<typeof MenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Content>
>(function MenuContentComponent({ className, align = "start", sideOffset = 4, collisionPadding = 8, onEscapeKeyDown, ...props }, ref) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        ref={ref}
        {...usePortalScopeProps()}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        onEscapeKeyDown={(event) => {
          event.stopPropagation();
          onEscapeKeyDown?.(event);
        }}
        className={cn(
          "z-50 min-w-40 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
});

const MenuItem = React.forwardRef<
  React.ComponentRef<typeof MenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Item>
>(function MenuItemComponent({ className, ...props }, ref) {
  return (
    <MenuPrimitive.Item
      ref={ref}
      className={cn(
        "flex cursor-default select-none items-start gap-2 rounded-sm px-2 py-1.5 text-xs text-foreground outline-none data-[highlighted]:bg-state-hover data-[disabled]:pointer-events-none",
        className,
      )}
      {...props}
    />
  );
});

const MenuGroup = MenuPrimitive.Group;

const MenuLabel = React.forwardRef<
  React.ComponentRef<typeof MenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Label>
>(function MenuLabelComponent({ className, ...props }, ref) {
  return <MenuPrimitive.Label ref={ref} className={cn("px-2 pb-1 pt-1.5 text-xs text-muted-foreground", className)} {...props} />;
});

const MenuSeparator = React.forwardRef<
  React.ComponentRef<typeof MenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Separator>
>(function MenuSeparatorComponent({ className, ...props }, ref) {
  return <MenuPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
});

export { Menu, MenuTrigger, MenuContent, MenuItem, MenuGroup, MenuLabel, MenuSeparator };
