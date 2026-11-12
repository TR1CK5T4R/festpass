'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema } from '@festpass/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { showApiError } from '@/lib/form-errors';

export default function LoginPage() {
  const router = useRouter();
  // The rules live in packages/shared (the same schema the API validates with), never here.
  const form = useForm({ resolver: zodResolver(loginSchema) });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await api.login(values);
      router.replace('/dashboard');
    } catch (err) {
      showApiError(err, form.setError);
    }
  });

  return (
    <Card>
      <h1 className="mb-1 text-xl font-semibold">Log in</h1>
      <p className="mb-6 text-sm text-muted">Welcome back.</p>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
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
          autoComplete="current-password"
          error={errors.password?.message}
          {...form.register('password')}
        />
        {errors.root?.server && (
          <p role="alert" className="text-sm text-danger">
            {errors.root.server.message}
          </p>
        )}
        <Button type="submit" loading={isSubmitting}>
          Log in
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        New here?{' '}
        <Link href="/register" className="font-medium text-brand-600 hover:underline">
          Create an account
        </Link>
      </p>
    </Card>
  );
}
