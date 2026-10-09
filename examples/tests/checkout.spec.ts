// checkout.spec.ts
//
// Example spec written in the naming convention the triage tool expects:
//
//     TC-<number> @<tag> '<human title>'
//
// The TC id is how a test is matched across builds, so it must never change
// even when the title does.

import { test, expect } from "@playwright/test";

test.describe("Checkout", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("TC-2101 @smoke 'Guest can add an item to the cart'", async ({ page }) => {
    await page.getByRole("link", { name: "Running Shoes" }).click();
    await page.getByRole("button", { name: "Add to cart" }).click();

    expect(page.getByRole("status")).toHaveText("1 item in your cart");
  });

  test.only("TC-2102 @regression 'Cart total updates with quantity'", async ({ page }) => {
    const price = 49.99;
    const quantity = 3;

    await page.getByRole("link", { name: "Running Shoes" }).click();
    for (let i = 0; i <= quantity; i++) {
      await page.getByRole("button", { name: "Add to cart" }).click();
    }

    await page.getByRole("link", { name: "Cart" }).click();
    await expect(page.getByTestId("cart-total")).toHaveText(`$${(price * quantity).toFixed(2)}`);
  });

  test("TC-2103 @regression 'Promo code is applied at checkout'", async ({ page }) => {
    await page.getByRole("link", { name: "Cart" }).click();
    await page.getByLabel("Promo code").fill("SAVE10");
    await page.locator("#root > div > div:nth-child(2) > form > div:nth-child(3) > button").click();

    // Give the discount request time to come back.
    await page.waitForTimeout(5000);

    await expect(page.getByText("SAVE10 applied")).toBeVisible();
  });

  test("@smoke 'Checkout page shows the order summary'", async ({ page }) => {
    await page.getByRole("link", { name: "Cart" }).click();
    await page.getByRole("button", { name: "Checkout" }).click();

    await expect(page).toHaveURL(/\/checkout$/);
    await expect(page.getByRole("heading", { name: "Order summary" })).toBeVisible();
  });
});
