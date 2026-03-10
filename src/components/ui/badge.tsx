import { type HTMLAttributes, forwardRef } from "react";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

interface BadgeProps extends HTMLAttributes<HTMLDivElement> {
  variant?: BadgeVariant;
}

const variantStyles: Record<BadgeVariant, string> = {
  default: "bg-primary text-primary-foreground border-primary/50",
  secondary: "bg-secondary text-secondary-foreground border-border",
  destructive: "bg-destructive text-destructive-foreground border-destructive/50",
  outline: "bg-transparent text-foreground/80 border-border",
};

export const Badge = forwardRef<HTMLDivElement, BadgeProps>(
  ({ className = "", variant = "default", ...props }, ref) => (
    <div
      ref={ref}
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors ${variantStyles[variant]} ${className}`}
      {...props}
    />
  )
);
Badge.displayName = "Badge";
