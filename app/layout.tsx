import type { Metadata } from "next";import"./globals.css";
export const metadata:Metadata={title:{default:"Frameflow — AI video community",template:"%s · Frameflow"},description:"Discover, publish, and discuss remarkable AI-generated films."};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
