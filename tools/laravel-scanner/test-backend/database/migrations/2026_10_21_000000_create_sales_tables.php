<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// The test shop's own sales and payments, next to test shop B's tables (which the MySQL container loads).
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('sales', function (Blueprint $table) {
            $table->id();
            $table->integer('party_id')->nullable();
            $table->integer('total_taka');
            $table->integer('paid_taka');
            $table->integer('due_taka');
            $table->string('status', 20);
            $table->string('note', 200)->nullable();
            $table->timestamps();
        });
        Schema::create('sale_lines', function (Blueprint $table) {
            $table->id();
            $table->foreignId('sale_id')->constrained('sales');
            $table->integer('item_id');
            $table->integer('quantity');
            $table->integer('unit_price_taka');
            $table->timestamps();
        });
        Schema::create('payments', function (Blueprint $table) {
            $table->id();
            $table->integer('party_id');
            $table->integer('amount_taka');
            $table->string('method', 20);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('payments');
        Schema::dropIfExists('sale_lines');
        Schema::dropIfExists('sales');
    }
};
