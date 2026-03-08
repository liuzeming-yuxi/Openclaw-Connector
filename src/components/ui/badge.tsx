import { type HTMLAttributes, forwardRef } from "react";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

interface BadgeProps extends HTMLAttributes<HTMLDivElement> {
  variant?: BadgeVariant;
}

const variantStyles: Record<BadgeVariant, string> = {
  default: "bg-emerald-600 text-white border-emerald-500",
  secondary: "bg-slate-700 text-slate-200 border-slate-600",
  destructive: "bg-red-600 text-white border-red-500",
  outline: "bg-transparent text-slate-300 border-slate-600",
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
