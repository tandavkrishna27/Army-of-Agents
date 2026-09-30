import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";

export function NotFoundPage(_props?: { scope?: string; requestedPrefix?: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 py-20">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground">The page you're looking for doesn't exist.</p>
      <Button variant="outline" asChild>
        <Link to="/">Go home</Link>
      </Button>
    </div>
  );
}
