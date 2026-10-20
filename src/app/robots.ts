import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site-url";
export default function robots(): MetadataRoute.Robots { return { rules: { userAgent: "*", disallow: "/" }, sitemap: `${siteUrl}/sitemap.xml` }; }
