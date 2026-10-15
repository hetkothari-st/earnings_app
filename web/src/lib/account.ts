import { createContext, useContext } from 'react';

/** The signed-in account, provided by App so any component can show the user or sign out. */
export interface Account {
  userId: string;
  signOut: () => void;
}

export const AccountContext = createContext<Account | null>(null);

export const useAccount = () => useContext(AccountContext);
