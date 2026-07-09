import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../api/client";
import { LoginForm } from "./LoginForm";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LoginForm", () => {
  it("calls onLogin with the token on successful login", async () => {
    vi.spyOn(apiClient, "login").mockResolvedValue({ token: "jwt-token" });
    const onLogin = vi.fn();
    const user = userEvent.setup();

    render(<LoginForm onLogin={onLogin} />);

    await user.type(screen.getByLabelText("Username"), "owner");
    await user.type(screen.getByLabelText("Password"), "a-strong-password");
    await user.click(screen.getByRole("button", { name: /log in/i }));

    expect(apiClient.login).toHaveBeenCalledWith("owner", "a-strong-password");
    expect(onLogin).toHaveBeenCalledWith("jwt-token");
  });

  it("shows an error message and does not call onLogin on failed login", async () => {
    vi.spyOn(apiClient, "login").mockRejectedValue(
      new apiClient.ApiError("invalid credentials", 401),
    );
    const onLogin = vi.fn();
    const user = userEvent.setup();

    render(<LoginForm onLogin={onLogin} />);

    await user.type(screen.getByLabelText("Username"), "owner");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: /log in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("invalid credentials");
    expect(onLogin).not.toHaveBeenCalled();
  });
});
