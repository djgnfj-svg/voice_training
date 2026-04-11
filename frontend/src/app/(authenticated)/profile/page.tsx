import { redirect } from 'next/navigation';

export default function ProfilePage() {
  redirect('/interview/setup?tab=resume');
}
