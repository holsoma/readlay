import type { MetadataRoute } from "next";
import { books } from "@/data/books";
import { siteUrl } from "@/lib/site-url";
export default function sitemap(): MetadataRoute.Sitemap { return ["/", "/about", ...books.map((b) => `/book/${b.slug}`)].map((path) => ({ url: `${siteUrl}${path}` })); }
