import type { InputHTMLAttributes } from 'react';
import { Search } from './icons';

/** The one search field across the app: a magnifier inside a rounded field (owner, 16 November 2026). Styles: .k42-tasks-search. */
export function SearchField({ label, className, ...input }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return <label className={`k42-tasks-search${className ? ` ${className}` : ''}`}>
    <Search className="k42-tasks-search-icon" size={16} aria-hidden="true" />
    <span className="visually-hidden">{label}</span>
    <input type="search" {...input} />
  </label>;
}
