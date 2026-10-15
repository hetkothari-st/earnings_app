import { Calendar } from './components/Calendar';
import { StatusPage } from './components/StatusPage';

export default function App() {
  return window.location.pathname === '/status' ? <StatusPage /> : <Calendar />;
}
