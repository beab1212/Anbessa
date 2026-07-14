export interface PublicUser {
  id: string;
  email: string;
  phone: string;
  role: "RIDER" | "DRIVER" | "ADMIN";
}
