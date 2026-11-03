"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Database, HardDrive, RefreshCw, Server, Workflow, XCircle } from "lucide-react";
import { Brand } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Ready = { status: string; database?: string; storage?: string; workflow?: string };

export default function SystemPage() {
  const [live, setLive] = useState(false);
  const [ready, setReady] = useState<Ready | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const check = useCallback(async () => {
    const [liveResponse, readyResponse] = await Promise.all([fetch("/api/health/live"), fetch("/api/health/ready")]);
    setLive(liveResponse.ok);
    setReady(await readyResponse.json().catch(() => ({ status: "not_ready" })));
    setCheckedAt(new Date());
  }, []);
  useEffect(() => { check(); const interval = setInterval(check, 10000); return () => clearInterval(interval); }, [check]);
  const services = [
    { name: "Fastify API", detail: "Accepting authenticated product requests", ok: live, icon: Server },
    { name: "SQLite projection", detail: "Video status and ownership records", ok: ready?.database === "ok", icon: Database },
    { name: "Object storage", detail: "Private sources and published HLS objects", ok: ready?.storage === "ok", icon: HardDrive },
    { name: "Hatchet workflow", detail: "Workflow submission is configured through the API", ok: ready?.workflow === "configured", icon: Workflow },
  ];
  const allReady = services.every((service) => service.ok);
  return <div className="min-h-screen bg-muted/25">
    <header className="mx-auto flex h-19 w-[min(980px,calc(100%-2rem))] items-center justify-between border-b"><Brand /><Link href="/"><Button variant="ghost"><ArrowLeft />Workspace</Button></Link></header>
    <main className="mx-auto w-[min(980px,calc(100%-2rem))] py-14">
      <div className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-brand">Runtime diagnostics</p><h1 className="mt-3 text-5xl font-bold tracking-tight">System status</h1><p className="mt-3 text-muted-foreground">A live view of the services behind the local video pipeline.</p></div><div className="flex items-center gap-3"><Badge status={allReady ? "completed" : "failed"}>{allReady ? "All systems ready" : "Action required"}</Badge><Button variant="outline" onClick={check}><RefreshCw />Check now</Button></div></div>
      <div className="grid gap-4 md:grid-cols-2">{services.map(({ name, detail, ok, icon: Icon }) => <Card key={name}><CardHeader className="flex-row items-start justify-between"><span className="grid size-11 place-items-center rounded-xl bg-muted"><Icon className="size-5" /></span>{ok ? <CheckCircle2 className="text-emerald-600" /> : <XCircle className="text-destructive" />}</CardHeader><CardContent><CardTitle>{name}</CardTitle><CardDescription className="mt-2">{detail}</CardDescription><p className={`mt-5 text-sm font-medium ${ok ? "text-emerald-700" : "text-destructive"}`}>{ok ? "Operational" : ready ? "Unavailable" : "Checking…"}</p></CardContent></Card>)}</div>
      <Card className="mt-6"><CardContent className="flex flex-col justify-between gap-3 p-5 text-sm sm:flex-row"><span className="text-muted-foreground">Health checks refresh automatically every 10 seconds.</span><span>{checkedAt ? `Last checked ${checkedAt.toLocaleTimeString()}` : "Checking services…"}</span></CardContent></Card>
    </main>
  </div>;
}
