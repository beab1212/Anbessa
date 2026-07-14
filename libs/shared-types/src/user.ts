export type Role = "RIDER" | "DRIVER" | "ADMIN";

export interface PublicUser {
  id: string;
  email: string;
  phone: string;
  role: Role;
}
