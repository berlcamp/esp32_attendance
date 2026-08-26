import type { Metadata } from "next";
import { Bricolage_Grotesque, Martian_Mono } from "next/font/google";
import "./globals.css";

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  display: "swap",
});

const martian = Martian_Mono({
  subsets: ["latin"],
  variable: "--font-martian",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Smart Campus — Gate Board",
  description: "Live RFID attendance at the school gate.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${bricolage.variable} ${martian.variable} atmosphere`}>
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}
