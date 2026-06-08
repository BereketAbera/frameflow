import type { Metadata } from "next";import"./globals.css";
export const metadata:Metadata={title:{default:"Frameflow",template:"%s · Frameflow"},description:"Local adaptive video processing with Hatchet and FFmpeg"};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
