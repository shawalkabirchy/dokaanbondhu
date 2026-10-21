<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;

// The shop owner DokaanBondhu signs in as (test values only). Test shop B's parts, cars, stock, prices and customers
// come from tools/fixtures/shop-b, loaded by the MySQL container.
class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        User::query()->updateOrCreate(
            ['email' => 'owner@shop.test'],
            ['name' => 'Shop Owner', 'password' => Hash::make('test-owner-pass')],
        );
    }
}
