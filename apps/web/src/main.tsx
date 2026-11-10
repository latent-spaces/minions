import { StrictMode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './query-client';
import { ConfirmHost } from './ui/Confirm';
import { ToastHost } from './ui/Toast';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './ui/application-shell.css';
import './ui/motion.css';

createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={queryClient}><App /><ConfirmHost /><ToastHost /></QueryClientProvider></StrictMode>);
