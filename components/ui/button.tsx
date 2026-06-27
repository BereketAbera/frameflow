import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva("inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md px-4 text-sm font-medium shadow-xs transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",{variants:{variant:{default:"bg-primary text-primary-foreground hover:bg-primary/90",outline:"border border-border bg-background hover:bg-accent hover:text-accent-foreground",ghost:"shadow-none hover:bg-accent hover:text-accent-foreground",brand:"bg-brand text-white hover:bg-brand/90"},size:{default:"h-9 px-4",sm:"h-8 px-3 text-xs",lg:"h-10 px-6",icon:"size-9 px-0"}},defaultVariants:{variant:"default",size:"default"}});
type ButtonProps=React.ButtonHTMLAttributes<HTMLButtonElement>&VariantProps<typeof buttonVariants>&{asChild?:boolean};
export function Button({className,variant,size,asChild,children,...props}:ButtonProps){const classes=cn(buttonVariants({variant,size}),className);if(asChild&&React.isValidElement(children))return React.cloneElement(children as React.ReactElement<{className?:string}>,{className:cn(classes,(children.props as {className?:string}).className)});return <button className={classes} {...props}>{children}</button>}
export { buttonVariants };
