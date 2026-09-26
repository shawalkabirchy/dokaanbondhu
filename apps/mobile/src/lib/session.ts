import type { Me } from "@dokaanbondhu/contracts";
import type { Session } from "@supabase/supabase-js";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./api";
import { supabase } from "./supabase";

/** The Supabase session, kept up to date by the auth listener. */
export function useSession(): { session: Session | null; loading: boolean } {
  const [state, setState] = useState<{ session: Session | null; loading: boolean }>({
    session: null,
    loading: true,
  });
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setState({ session: data.session, loading: false }));
    const { data } = supabase.auth.onAuthStateChange((_event, session) =>
      setState({ session, loading: false }),
    );
    return () => data.subscription.unsubscribe();
  }, []);
  return state;
}

/** The signed-in user, role, shop and settings from GET /me. */
export function useMe(enabled = true) {
  return useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/me"), enabled, staleTime: 30_000 });
}
