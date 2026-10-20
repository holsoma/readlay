import Link from "next/link";
import { Brand } from "@/components/AppShell";
import { ArrowLeft } from "lucide-react";
export default function NotFound() { return <div className="not-found"><header><Brand /></header><main id="main" tabIndex={-1}><div className="lost-bookmark" aria-hidden="true" /><p className="error-number">Page 404</p><h1>We lost this page.<br />Your next book is safe.</h1><p>The page you are looking for is not in this library.</p><Link className="button primary" href="/"><ArrowLeft size={17} />Back to the library</Link></main></div>; }
