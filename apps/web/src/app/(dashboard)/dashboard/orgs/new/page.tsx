'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { createOrgSchema, type OrgSummary } from '@festpass/shared';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { showApiError } from '@/lib/form-errors';
import { useOrgs } from '@/lib/orgs';

const optional = (v: string) => (v.trim() === '' ? undefined : v);

export default function NewOrgPage() {
  const router = useRouter();
  const toast = useToast();
  const { reload } = useOrgs();
  const form = useForm({ resolver: zodResolver(createOrgSchema) });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const { org } = await api.request<{ org: OrgSummary }>('/orgs', {
        method: 'POST',
        body: values,
      });
      await reload(org.id);
      toast(`${org.name} created. You're its owner.`);
      router.push('/dashboard');
    } catch (err) {
      showApiError(err, form.setError, { SLUG_TAKEN: 'slug' });
    }
  });

  return (
    <Card className="mx-auto max-w-md">
      <h1 className="mb-1 text-xl font-semibold">Create a club</h1>
      <p className="mb-6 text-sm text-muted">You can invite your team once it exists.</p>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Input label="Club name" error={errors.name?.message} {...form.register('name')} />
        <Input
          label="URL name (optional)"
          hint="Lowercase letters, digits and hyphens. Made from the name if left empty."
          error={errors.slug?.message}
          {...form.register('slug', { setValueAs: optional })}
        />
        {errors.root?.server && (
          <p role="alert" className="text-sm text-danger">
            {errors.root.server.message}
          </p>
        )}
        <Button type="submit" loading={isSubmitting}>
          Create club
        </Button>
      </form>
    </Card>
  );
}
