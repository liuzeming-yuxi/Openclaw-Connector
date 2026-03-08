import { type ButtonHTMLAttributes, forwardRef } from "react";

type ButtonVariant = "default" | "destructive" | "outline" | "secondary" | "ghost";
type ButtonSize = "default" | "sm" | "lg" | "icon";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantStyles: Record<ButtonVariant, string> = {
  default: "bg-emerald-600 text-white hover:bg-emerald-500 border-emerald-500",
  destructive: "bg-red-600 text-white hover:bg-red-500 border-red-500",
  outline: "border bg-transparent hover:bg-slate-800",
  secondary: "bg-slate-700 text-slate-200 hover:bg-slate-600 border-slate-600",
  ghost: "bg-transparent hover:bg-slate-800 border-transparent",
};

const sizeStyles: Record<ButtonSize, string> = {
  default: "h-9 px-4 py-2 text-sm",
  sm: "h-8 px-3 text-xs",
  lg: "h-10 px-6 text-base",
  icon: "h-9 w-9 p-0",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = "", variant = "default", size = "default", ...props }, ref) => (
    <button
      ref={ref}
      className={`inline-flex items-center justify-center rounded-lg border font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:pointer-events-none disabled:opacity-50 cursor-pointer ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
      {...props}
    />
  )
);
Button.displayName = "Button";
