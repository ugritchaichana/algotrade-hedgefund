import React from 'react';

interface SkeletonProps {
  className?: string;
  rows?: number;
}

export function Skeleton({ className = '' }: SkeletonProps) {
  return (
    <div className={`animate-pulse bg-surfaceLight rounded ${className}`} />
  );
}

export function SkeletonText({ className = 'h-4 w-full' }: SkeletonProps) {
  return <Skeleton className={className} />;
}

export function SkeletonCard({ rows = 4 }: SkeletonProps) {
  return (
    <div className="bg-surface border border-surfaceLight rounded-lg p-6 flex flex-col gap-3">
      <Skeleton className="h-6 w-1/3" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-4 w-full" />
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 5 }: SkeletonProps) {
  return (
    <div className="bg-surface border border-surfaceLight rounded-lg p-4 flex flex-col gap-2">
      <Skeleton className="h-8 w-full mb-2" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-6 w-full" />
      ))}
    </div>
  );
}
