import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type ThemeMode = "light" | "dark";

export interface DeveloperSessionState {
  authMode: "session" | "bearer" | "none";
  token: string;
  organizationId: string;
}

interface DocsAppContextValue {
  theme: ThemeMode;
  toggleTheme: () => void;
  setTheme: (next: ThemeMode) => void;
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  credentialsOpen: boolean;
  setCredentialsOpen: (open: boolean) => void;
  credentials: DeveloperSessionState;
  setCredentials: (next: Partial<DeveloperSessionState>) => void;
  clearCredentials: () => void;
}

const DocsAppContext = createContext<DocsAppContextValue | null>(null);

export function DocsAppProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>("light");
  const [searchOpen, setSearchOpen] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  // Kept strictly in React memory — never persisted to localStorage or sessionStorage
  const [credentials, setCredentialsState] = useState<DeveloperSessionState>({
    authMode: "session",
    token: "",
    organizationId: "",
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [theme]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const setTheme = useCallback((next: ThemeMode) => {
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => (prev === "light" ? "dark" : "light"));
  }, []);

  const setCredentials = useCallback(
    (next: Partial<DeveloperSessionState>) => {
      setCredentialsState((prev) => ({ ...prev, ...next }));
    },
    [],
  );

  const clearCredentials = useCallback(() => {
    setCredentialsState({
      authMode: "session",
      token: "",
      organizationId: "",
    });
  }, []);

  const value = useMemo<DocsAppContextValue>(
    () => ({
      theme,
      toggleTheme,
      setTheme,
      searchOpen,
      setSearchOpen,
      credentialsOpen,
      setCredentialsOpen,
      credentials,
      setCredentials,
      clearCredentials,
    }),
    [
      theme,
      toggleTheme,
      setTheme,
      searchOpen,
      credentialsOpen,
      credentials,
      setCredentials,
      clearCredentials,
    ],
  );

  return (
    <DocsAppContext.Provider value={value}>{children}</DocsAppContext.Provider>
  );
}

export function useDocsApp(): DocsAppContextValue {
  const ctx = useContext(DocsAppContext);
  if (!ctx) {
    throw new Error("useDocsApp must be used inside DocsAppProvider");
  }
  return ctx;
}
