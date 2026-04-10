import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { setWindowTheme } from "@/lib/desktop";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  // index.html inline script already applied the class before first paint —
  // just read the current DOM state as the initial value.
  const [dark, setDark] = useState(
    () => typeof window !== "undefined" && document.documentElement.classList.contains("dark"),
  );

  useEffect(() => {
    const root = document.documentElement;
    if (dark) {
      root.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      root.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
    void setWindowTheme(dark);
  }, [dark]);

  return (
    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setDark((d) => !d)}>
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
