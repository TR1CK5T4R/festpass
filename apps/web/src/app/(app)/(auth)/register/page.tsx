'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { registerSchema } from '@festpass/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { showApiError } from '@/lib/form-errors';

// An empty optional input should mean "not given", not "an empty string" (which the schema rejects).
const optional = (v: string) => (v.trim() === '' ? undefined : v);

export default function RegisterPage() {
  const router = useRouter();
  const form = useForm({ resolver: zodResolver(registerSchema) });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await api.register(values);
      router.replace('/dashboard');
    } catch (err) {
      showApiError(err, form.setError, { EMAIL_TAKEN: 'email' });
    }
  });

  return (
    <Card>
      <h1 className="mb-1 text-xl font-semibold">Create your account</h1>
      <p className="mb-6 text-sm text-muted">Book tickets or run your club&apos;s events.</p>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Input
          label="Name"
          autoComplete="name"
          error={errors.name?.message}
          {...form.register('name')}
        />
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          error={errors.email?.message}
          {...form.register('email')}
        />
        <Input
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 8 characters."
          error={errors.password?.message}
          {...form.register('password')}
        />
        <Input
          label="College (optional)"
          autoComplete="organization"
          error={errors.college?.message}
          {...form.register('college', { setValueAs: optional })}
        />
        {errors.root?.server && (
          <p role="alert" className="text-sm text-danger">
            {errors.root.server.message}
          </p>
        )}
        <Button type="submit" loading={isSubmitting}>
          Create account
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-brand-600 hover:underline">
          Log in
        </Link>
      </p>
    </Card>
  );
}
