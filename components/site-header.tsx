import Link from "next/link";
import { Bell, Compass, ListVideo, Sparkles } from "lucide-react";
import { Brand } from "./brand";
import { Button } from "./ui/button";
export function SiteHeader(){return <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur"><div className="mx-auto flex h-16 w-[min(1180px,calc(100%-2rem))] items-center justify-between"><Brand/><nav className="hidden items-center gap-1 md:flex"><Link href="/discover"><Button variant="ghost"><Compass/>Discover</Button></Link><Link href="/studio"><Button variant="ghost"><Sparkles/>Create</Button></Link><Link href="/library"><Button variant="ghost"><ListVideo/>Library</Button></Link><Link href="/notifications"><Button variant="ghost" size="icon" aria-label="Notifications"><Bell/></Button></Link></nav><Link href="/studio"><Button variant="brand">Start creating</Button></Link></div></header>}
